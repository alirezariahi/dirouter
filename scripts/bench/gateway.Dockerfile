# Benchmark-only runtime keep-alive alignment; application source is unchanged.
FROM dirouter-bench/gateway:current
RUN sed -i 's/keepAliveTimeout: 30_000/keepAliveTimeout: 25_000/' /app/dist/upstream.js \
    && grep -q 'keepAliveTimeout: 25_000' /app/dist/upstream.js
