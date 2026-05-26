// Global test setup and teardown
import { prisma, disconnectDatabase } from '../../src/config/database';
import { disconnectRedis } from '../../src/config/redis';
import { closeQueues } from '../../src/config/queue';

// Mock logger to keep test output clean
jest.mock('../../src/utils/logger', () => {
  const mockLogger = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  };
  return {
    logger: mockLogger,
    createChildLogger: jest.fn(() => mockLogger),
  };
});

beforeAll(async () => {
  // Ensure we can connect to test databases
  try {
    await prisma.$connect();
  } catch (error) {
    console.error('Failed to connect to test DB:', error);
  }
});

afterAll(async () => {
  // Clean up connections after tests
  await disconnectDatabase();
  await closeQueues();
  await disconnectRedis();
});

afterEach(async () => {
  // Clean up database tables between tests if needed
  // Note: For unit tests, we'll mock Prisma instead of using the real DB.
  // For integration tests, we'd truncate tables here.
  jest.clearAllMocks();
});
