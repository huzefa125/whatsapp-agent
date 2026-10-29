import { Router } from 'express';
import { BrowserController } from '../controllers/browser.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

router.get('/connections', BrowserController.listConnections);
router.post('/connections', BrowserController.connect);
router.delete('/connections/:id', BrowserController.disconnect);
router.get('/handoffs', BrowserController.listHandoffs);
router.post('/handoffs/:id/cancel', BrowserController.cancelHandoff);
router.get('/runs/:id', BrowserController.getRun);
router.post('/runs/:id/cancel', BrowserController.cancelRun);

export default router;
