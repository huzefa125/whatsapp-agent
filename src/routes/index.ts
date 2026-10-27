import { Router } from 'express';
import healthRoutes from './health.routes';
import webhookRoutes from './webhook.routes';
import authRoutes from './auth.routes';
import agentRoutes from './agent.routes';

const router = Router();

router.use('/health', healthRoutes);
router.use('/webhook', webhookRoutes);
router.use('/api/auth', authRoutes);
router.use('/auth', authRoutes);
router.use('/api/agent', agentRoutes);

export default router;
