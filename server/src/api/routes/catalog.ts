import type { FastifyInstance } from 'fastify';
import type { CatalogService } from '../../domain/services/catalog-service.ts';

/** 目录查询与手工重建索引，供后台与联调使用 */
export function registerCatalogRoutes(app: FastifyInstance, catalog: CatalogService): void {
  app.get('/api/packs', async () => ({ packs: catalog.listPacks() }));

  app.get('/api/sources', async () => ({ sources: catalog.listSources() }));

  app.post('/api/reindex', async (request) => {
    const result = catalog.reindex();
    request.log.info(result, '重建索引');
    return result;
  });
}
