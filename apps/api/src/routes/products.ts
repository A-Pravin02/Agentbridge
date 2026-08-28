// ============================================
// AgentBridge - Product Routes
// Product discovery and search endpoints
// ============================================

import { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';

export async function productRoutes(app: FastifyInstance) {
  // GET /products - List all products for a merchant
  app.get('/products', async (request, reply) => {
    const { merchantId } = request.query as { merchantId?: string };
    const where = merchantId ? { merchantId } : {};
    
    const products = await prisma.product.findMany({
      where,
      orderBy: { price: 'asc' },
    });
    
    return { success: true, data: products };
  });

  // GET /products/:id - Get a single product
  app.get('/products/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    
    const product = await prisma.product.findUnique({ where: { id } });
    
    if (!product) {
      return reply.status(404).send({ success: false, error: 'Product not found' });
    }
    
    return { success: true, data: product };
  });

  // GET /products/search - Search products
  app.get('/products/search', async (request, reply) => {
    const { query, maxPrice, category, merchantId } = request.query as {
      query?: string;
      maxPrice?: string;
      category?: string;
      merchantId?: string;
    };

    const where: Record<string, unknown> = {};
    
    if (merchantId) where.merchantId = merchantId;
    if (category) where.category = category;
    if (maxPrice) where.price = { lte: parseFloat(maxPrice) };
    if (query) where.name = { contains: query };

    const products = await prisma.product.findMany({
      where,
      orderBy: { price: 'asc' },
    });

    return { success: true, data: products, total: products.length };
  });
}
