import "dotenv/config";

// Tests always run against the dedicated test database, never the development one.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
