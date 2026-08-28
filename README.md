# AgentBridge

**The Authorization Layer for AI Commerce**

AgentBridge is a Merchant AI Commerce Gateway that enables merchants to become AI-transactable — with deterministic financial controls, policy-based authorization, and a tamper-evident audit trail.

## Problem

AI agents can recommend products but cannot reliably and safely complete commerce transactions. Even if they could, merchants and users cannot give an autonomous AI unlimited access to money.

## Solution

AgentBridge provides:

- **Machine-readable product discovery** — AI agents can search and select products
- **Deterministic policy engine** — ALLOW / REQUIRE_APPROVAL / BLOCK decisions
- **Agent Permission Passport** — identity, permissions, and financial limits per agent
- **Payment integration** — Razorpay test-mode with server-side verification
- **Tamper-evident audit trail** — every action is hashed and traceable
- **Merchant dashboard** — real-time visibility and control

## Architecture

```
USER → AI AGENT → MCP TOOLS → PRODUCT DISCOVERY → PURCHASE INTENT
  → POLICY ENGINE → ALLOW / REQUIRE_APPROVAL / BLOCK
  → PAYMENT → VERIFICATION → AUDIT
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js, TypeScript, Tailwind CSS, shadcn/ui |
| Backend | Node.js, TypeScript, Fastify, Prisma |
| Database | PostgreSQL |
| Payments | Razorpay (Test Mode) |
| AI Integration | MCP (Model Context Protocol) |
| Real-time | Socket.IO |

## Getting Started

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Start development
npm run dev
```

## Demo Merchant: TechKart

| Product | Price | Category | Decision |
|---------|-------|----------|----------|
| USB-C Cable | ₹299 | Electronics Accessories | ✅ ALLOW |
| Premium Phone Case | ₹399 | Phone Accessories | ✅ ALLOW |
| Premium Case | ₹499 | Phone Accessories | ⚠️ REQUIRE_APPROVAL |
| Power Bank | ₹1,499 | Electronics | 🚫 BLOCK |
| Bluetooth Speaker | ₹2,999 | Electronics | 🚫 BLOCK |

## License

MIT
