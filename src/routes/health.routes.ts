import { Router } from 'express';
import { HealthController } from '../controllers/health.controller';

const router = Router();

router.get('/live', HealthController.getLiveness);
router.get('/ready', (req, res, next) => {
  HealthController.getReadiness(req, res).catch(next);
});

export default router;
