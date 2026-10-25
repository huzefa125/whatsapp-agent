import { Router } from 'express';
import healthRoutes from './health.routes';
import webhookRoutes from './webhook.routes';
import authRoutes from './auth.routes';

const router = Router();

router.use('/health', healthRoutes);
router.use('/webhook', webhookRoutes);
router.use('/api/auth', authRoutes);
router.use('/auth', authRoutes);

export default router;
