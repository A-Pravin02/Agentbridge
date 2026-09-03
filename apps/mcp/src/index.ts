// ============================================
// AgentBridge - MCP Server
// ============================================
//
// The tool surface an AI agent sees. Three design rules, all deliberate:
//
// 1. NO PAYMENT PRIMITIVE. There is no `execute_payment` tool and no way to
//    reach one. The model can propose a purchase and read its status; the
//    settlement path requires a provider signature the model never possesses.
//
// 2. IDENTITY IS NOT AN ARGUMENT. The Phase 0 audit found `agentId` was a tool
//    argument chosen by the model — the confused-deputy problem in its purest
//    form. Identity now comes from a private key held by this process and
//    loaded from the environment. The model cannot name which agent to be,
//    cannot see the key, and cannot sign anything itself.
//
// 3. EVERY REQUEST IS SIGNED. This process is the agent's credential holder.
//    It signs each call with Ed25519 over the canonical request, so the server
//    can verify origin and integrity independently of anything the model said.
//
// The model is untrusted input all the way down. The server re-derives price,
// tenancy and policy for itself, so a prompt-injected tool call is just a
// proposal that gets refused.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { createHash, createPrivateKey, randomUUID, sign as edSign } from 'crypto';
import { readFileSync } from 'fs';
import { z } from 'zod';

// ---- Identity ----

interface Identity {
  keyId: string;
  privateKey: string;
}

function loadIdentity(): Identity {
  const keyId = process.env.AGENTBRIDGE_KEY_ID;
  const privateKey = process.env.AGENTBRIDGE_PRIVATE_KEY;
  if (keyId && privateKey) return { keyId, privateKey };

  // Convenience for local development: read the seed's generated identity.
  const path = process.env.AGENTBRIDGE_IDENTITY_FILE;
  if (path) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Identity;
    if (parsed.keyId && parsed.privateKey) return parsed;
  }

  throw new Error(
    'AgentBridge MCP requires an agent identity. Set AGENTBRIDGE_KEY_ID and ' +
      'AGENTBRIDGE_PRIVATE_KEY, or AGENTBRIDGE_IDENTITY_FILE pointing at the ' +
      'JSON written by the seed. The private key is never exposed to the model.'
  );
}

const API_BASE = (process.env.AGENTBRIDGE_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const identity = loadIdentity();

// ---- Signed transport ----

function canonicalRequest(params: {
  keyId: string;
  requestId: string;
  timestamp: string;
  method: string;
  path: string;
  bodyDigest: string;
}): string {
  return [
    'AGENTBRIDGE-ED25519-V1',
    params.keyId,
    params.requestId,
    params.timestamp,
    params.method.toUpperCase(),
    params.path,
    params.bodyDigest,
  ].join('\n');
}

async function callApi(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const requestId = randomUUID();
  const timestamp = String(Date.now());
  // Path is signed WITHOUT the query string, matching the server's canonical form.
  const pathForSigning = path.split('?')[0];

  const message = canonicalRequest({
    keyId: identity.keyId,
    requestId,
    timestamp,
    method,
    path: pathForSigning,
    bodyDigest: createHash('sha256').update(payload, 'utf8').digest('hex'),
  });

  const key = createPrivateKey({
    key: Buffer.from(identity.privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const signature = edSign(null, Buffer.from(message, 'utf8'), key).toString('base64');

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-agent-key-id': identity.keyId,
      'x-request-id': requestId,
      'x-timestamp': timestamp,
      'x-agent-signature': signature,
      'idempotency-key': randomUUID(),
    },
    body: method === 'POST' ? payload : undefined,
  });

  const data = await response.json().catch(() => ({ error: 'Response was not JSON' }));
  return { ok: response.ok, status: response.status, data };
}

// ---- Tool definitions ----
//
// Schemas are advisory to the model but authoritative here: arguments are
// parsed with Zod before any network call, so a malformed or hostile tool call
// fails locally rather than reaching the API.

const tools = [
  {
    name: 'search_products',
    description:
      "Search the merchant's catalogue. Returns authoritative prices — the price " +
      'shown here is the price the server will charge; it cannot be negotiated or overridden.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to match against product names' },
        category: { type: 'string', description: 'Filter by exact category' },
        maxPriceMinor: {
          type: 'number',
          description: 'Maximum price in minor units (paise). 50000 means ₹500.',
        },
      },
    },
    schema: z.object({
      query: z.string().max(120).optional(),
      category: z.string().max(120).optional(),
      maxPriceMinor: z.number().int().min(0).max(100_000_000).optional(),
    }),
  },
  {
    name: 'get_product',
    description: 'Retrieve one product by id, including its authoritative price and stock.',
    inputSchema: {
      type: 'object',
      properties: { productId: { type: 'string' } },
      required: ['productId'],
    },
    schema: z.object({ productId: z.string().min(1).max(64) }),
  },
  {
    name: 'get_my_limits',
    description:
      'Read this agent\'s permission passport and remaining daily budget. Use this ' +
      'before proposing a purchase to check whether it is likely to be permitted.',
    inputSchema: { type: 'object', properties: {} },
    schema: z.object({}),
  },
  {
    name: 'create_purchase_intent',
    description:
      'PROPOSE a purchase. This does not spend money and does not commit anything — ' +
      'it registers an intent that AgentBridge will independently authorize. The ' +
      'server computes the amount from its own catalogue; any amount you believe ' +
      'applies is ignored.',
    inputSchema: {
      type: 'object',
      properties: {
        productId: { type: 'string' },
        quantity: { type: 'number', description: 'Positive integer, at most 1000' },
        agentReason: {
          type: 'string',
          description: 'Why the user wants this. Shown to a human if approval is required.',
        },
      },
      required: ['productId', 'agentReason'],
    },
    schema: z.object({
      productId: z.string().min(1).max(64),
      quantity: z.number().int().min(1).max(1000).default(1),
      agentReason: z.string().max(500),
    }),
  },
  {
    name: 'request_authorization',
    description:
      'Submit a purchase intent for a decision. Returns ALLOW, REQUIRE_APPROVAL or ' +
      'BLOCK together with the exact rules evaluated. This decision is final and is ' +
      'made by a deterministic policy engine — it cannot be argued with, retried for ' +
      'a different answer, or influenced by how the request is phrased.',
    inputSchema: {
      type: 'object',
      properties: { purchaseIntentId: { type: 'string' } },
      required: ['purchaseIntentId'],
    },
    schema: z.object({ purchaseIntentId: z.string().min(1).max(64) }),
  },
  {
    name: 'get_purchase_status',
    description:
      'Check the current state of a purchase intent, including the decision, the ' +
      'reason, the risk score and whether a human approval is still pending.',
    inputSchema: {
      type: 'object',
      properties: { purchaseIntentId: { type: 'string' } },
      required: ['purchaseIntentId'],
    },
    schema: z.object({ purchaseIntentId: z.string().min(1).max(64) }),
  },
] as const;

// NOTE: there is deliberately no tool that settles a payment. Settlement needs
// a payment-provider signature, which this process does not hold and the model
// cannot obtain. An agent can get a purchase authorized; it cannot make money
// move on its own.

function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string, detail?: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message, detail }, null, 2) }],
    isError: true,
  };
}

async function dispatch(name: string, rawArgs: unknown): Promise<CallToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return fail(`Unknown tool: ${name}`);

  const parsed = tool.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return fail(
      'Invalid arguments',
      parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
    );
  }
  const args = parsed.data as Record<string, unknown>;

  switch (name) {
    case 'search_products': {
      const q = new URLSearchParams();
      if (args.query) q.set('query', String(args.query));
      if (args.category) q.set('category', String(args.category));
      if (args.maxPriceMinor !== undefined) q.set('maxPriceMinor', String(args.maxPriceMinor));
      const res = await callApi('GET', `/api/products${q.size ? `?${q}` : ''}`);
      return res.ok ? ok(res.data) : fail('Search failed', res.data);
    }

    case 'get_product': {
      const res = await callApi('GET', `/api/products/${encodeURIComponent(String(args.productId))}`);
      return res.ok ? ok(res.data) : fail('Product not found', res.data);
    }

    case 'get_my_limits': {
      const res = await callApi('GET', '/api/me');
      return res.ok ? ok(res.data) : fail('Could not read agent limits', res.data);
    }

    case 'create_purchase_intent': {
      const res = await callApi('POST', '/api/purchase-intents', {
        productId: args.productId,
        quantity: args.quantity ?? 1,
        agentReason: args.agentReason,
      });
      if (!res.ok) return fail('Purchase intent was refused', res.data);
      return ok({
        ...(res.data as object),
        nextStep: 'Call request_authorization with this purchase intent id.',
      });
    }

    case 'request_authorization': {
      const id = encodeURIComponent(String(args.purchaseIntentId));
      const res = await callApi('POST', `/api/purchase-intents/${id}/evaluate`, {});
      if (!res.ok) return fail('Authorization request was refused', res.data);

      const data = (res.data as { data?: Record<string, unknown> }).data ?? {};
      // Strip the approval token: it is a human's credential, and putting it in
      // the model's context would let the model act as the approver.
      const { approval, ...safe } = data as Record<string, unknown> & { approval?: unknown };
      return ok({
        ...safe,
        approvalPending: approval !== undefined,
        guidance:
          approval !== undefined
            ? 'A human must approve this purchase. Tell the user it is awaiting approval; you cannot approve it yourself.'
            : undefined,
      });
    }

    case 'get_purchase_status': {
      const id = encodeURIComponent(String(args.purchaseIntentId));
      const res = await callApi('GET', `/api/purchase-intents/${id}`);
      return res.ok ? ok(res.data) : fail('Purchase intent not found', res.data);
    }

    default:
      return fail(`Unhandled tool: ${name}`);
  }
}

// ---- Server ----

async function main() {
  const server = new Server(
    { name: 'agentbridge', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await dispatch(request.params.name, request.params.arguments);
    } catch (error) {
      // Never surface a stack trace or a connection string to the model.
      return fail(
        'The AgentBridge API could not be reached',
        error instanceof Error ? error.message.slice(0, 200) : undefined
      );
    }
  });

  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `AgentBridge MCP server ready (key ${identity.keyId}, api ${API_BASE})\n`
  );
}

main().catch((error) => {
  process.stderr.write(`AgentBridge MCP server failed to start: ${error}\n`);
  process.exit(1);
});
