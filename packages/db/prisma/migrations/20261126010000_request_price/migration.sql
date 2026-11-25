-- Async video tasks (card 30.6): a fixed cost per request (e.g. per generated video), next to the
-- per-second price that video generation shares with speech to text.
ALTER TABLE "models" ADD COLUMN "request_price" DECIMAL(18,8);
