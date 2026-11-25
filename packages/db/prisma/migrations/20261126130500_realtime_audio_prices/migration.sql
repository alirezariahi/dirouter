-- Realtime sessions (card 30.5): audio tokens have their own price per million, next to the text
-- token prices. Unset means the text input/output rate.
ALTER TABLE "models" ADD COLUMN "audio_input_price" DECIMAL(18,8);
ALTER TABLE "models" ADD COLUMN "audio_output_price" DECIMAL(18,8);
