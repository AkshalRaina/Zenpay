import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { apiRoutes } from './routes';
import { requestLogger } from './middleware/requestLogger';
import { rateLimiter } from './middleware/rateLimiter';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

/**
 * Express application setup.
 *
 * Middleware pipeline:
 * 1. Security (helmet)
 * 2. CORS
 * 3. Compression
 * 4. Body parsing
 * 5. Request logging (correlation ID)
 * 6. Rate limiting
 * 7. API routes
 * 8. 404 handler
 * 9. Global error handler
 */
const app = express();

// ─── Security & Utility Middleware ───
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Request Logging ───
app.use(requestLogger);

// ─── Rate Limiting ───
app.use(rateLimiter);

// ─── API Routes ───
app.use('/api/v1', apiRoutes);

// ─── Static Frontend UI ───
app.use(express.static('public'));

// ─── 404 Handler ───
app.use(notFoundHandler);

// ─── Global Error Handler ───
app.use(errorHandler);

export { app };
