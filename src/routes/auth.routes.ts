import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

// Passwordless initiation
router.post('/start', AuthController.start);

// Phone (WhatsApp) challenge
router.post('/challenge/phone/send', AuthController.sendPhoneOtp);
router.post('/challenge/phone/verify', AuthController.verifyPhoneOtp);

// Email challenge
router.post('/challenge/email/send', AuthController.sendEmailOtp);
router.post('/challenge/email/verify', AuthController.verifyEmailOtp);

// Session endpoints
router.get('/me', requireAuth, AuthController.me);
router.post('/logout', requireAuth, AuthController.logout);

export default router;
