import { Router } from 'express';
import { AgentTaskController } from '../controllers/agent-task.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

router.post('/tasks', AgentTaskController.create);
router.get('/tasks', AgentTaskController.list);
router.get('/tasks/:id', AgentTaskController.get);
router.post('/tasks/:id/cancel', AgentTaskController.cancel);
router.post('/tasks/:id/confirm', AgentTaskController.confirm);

export default router;
