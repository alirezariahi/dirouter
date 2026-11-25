-- Rerank (card 30.2): price per search unit (one query over up to 100 documents), as Cohere bills;
-- token-billed rerankers (Jina, Voyage) use the input price.
ALTER TABLE "models" ADD COLUMN "search_price" DECIMAL(18,8);
