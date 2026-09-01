// ============================================
// AgentBridge - MCP (Model Context Protocol) Server
// AI Agent Commerce Gateway Tools
// ============================================

import { createInterface } from 'readline';

const API_BASE = process.env.AGENTBRIDGE_API_URL || 'http://localhost:3001';

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const TOOLS: McpTool[] = [
  {
    name: 'search_products',
    description: 'Search the merchant catalog for products matching a query or category filter.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword to search in product title or description' },
        category: { type: 'string', description: 'Filter by category (e.g. Electronics Accessories, Phone Accessories)' },
        maxPrice: { type: 'number', description: 'Filter products with price <= maxPrice' },
      },
    },
  },
  {
    name: 'get_product',
    description: 'Retrieve detailed information, stock, and pricing for a specific product ID.',
    inputSchema: {
      type: 'object',
      properties: {
        productId: { type: 'string', description: 'The unique ID of the product' },
      },
      required: ['productId'],
    },
  },
  {
    name: 'create_purchase_intent',
    description: 'Submit an AI commerce purchase intent for deterministic policy authorization.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The registered Agent ID' },
        productId: { type: 'string', description: 'The ID of the product to purchase' },
        quantity: { type: 'number', description: 'Quantity of items (defaults to 1)' },
        agentReason: { type: 'string', description: 'Explanation or justification for why this purchase is being made' },
        merchantId: { type: 'string', description: 'Optional merchant ID (defaults to product merchant)' },
      },
      required: ['agentId', 'productId', 'agentReason'],
    },
  },
  {
    name: 'check_purchase_status',
    description: 'Query the current authorization status, decision, or payment state of a purchase intent.',
    inputSchema: {
      type: 'object',
      properties: {
        purchaseIntentId: { type: 'string', description: 'The purchase intent ID to check' },
      },
      required: ['purchaseIntentId'],
    },
  },
  {
    name: 'get_agent_limits',
    description: 'Retrieve the agent permission passport, remaining spending limits, and allowed categories.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The Agent ID to inspect' },
      },
      required: ['agentId'],
    },
  },
];

async function callTool(name: string, args: any) {
  try {
    switch (name) {
      case 'search_products': {
        const params = new URLSearchParams();
        if (args.query) params.set('query', args.query);
        if (args.category) params.set('category', args.category);
        const res = await fetch(`${API_BASE}/products?${params.toString()}`);
        const data: any = await res.json();
        let products = data.data || [];
        if (args.maxPrice !== undefined) {
          products = products.filter((p: any) => p.price <= args.maxPrice);
        }
        return { content: [{ type: 'text', text: JSON.stringify(products, null, 2) }] };
      }

      case 'get_product': {
        const res = await fetch(`${API_BASE}/products/${args.productId}`);
        const data = await res.json();
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'create_purchase_intent': {
        const res = await fetch(`${API_BASE}/purchase-intents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: args.agentId,
            productId: args.productId,
            quantity: args.quantity || 1,
            agentReason: args.agentReason,
            merchantId: args.merchantId,
          }),
        });
        const data: any = await res.json();
        if (!res.ok) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: data.error || 'Failed to create intent', code: data.code }, null, 2) }],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'check_purchase_status': {
        // Use direct ID endpoint — never fetch all transactions and filter in memory (GAP-04 fix)
        const res = await fetch(`${API_BASE}/purchase-intents/${args.purchaseIntentId}`);
        if (!res.ok) {
          const err: any = await res.json().catch(() => ({ error: 'Not found' }));
          return { content: [{ type: 'text', text: JSON.stringify({ error: err.error || 'Purchase intent not found' }) }], isError: true };
        }
        const data = await res.json();
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'get_agent_limits': {
        const res = await fetch(`${API_BASE}/agents`);
        const data: any = await res.json();
        const agent = (data.data || []).find((a: any) => a.id === args.agentId);
        if (!agent) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Agent not found' }) }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(agent, null, 2) }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err: any) {
    return { content: [{ type: 'text', text: `Error calling tool ${name}: ${err.message}` }], isError: true };
  }
}

/**
 * Handle incoming MCP JSON-RPC messages via stdio
 */
function handleMessage(msg: any) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'agentbridge-mcp-server',
          version: '0.1.0',
        },
      },
    };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  return null;
}

// Start stdio interface for MCP protocol
export function startServer() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  process.stderr.write('AgentBridge MCP Server listening on stdio (PID: ' + process.pid + ')\n');

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const msg = JSON.parse(trimmed);

      if (msg.method === 'tools/call') {
        const toolResult = await callTool(msg.params?.name, msg.params?.arguments || {});
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: toolResult,
        }) + '\n');
        return;
      }

      const response = handleMessage(msg);
      if (response) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } catch (err: any) {
      process.stderr.write(`Failed to process MCP request: ${err.message}\n`);
    }
  });
}

// If directly invoked via node/tsx
if (typeof process !== 'undefined' && process.argv && process.argv[1] && (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'))) {
  startServer();
}
