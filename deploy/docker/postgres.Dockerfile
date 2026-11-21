# PostgreSQL with the pgvector extension, for the semantic cache (card 13.2).
# Same base as the default `postgres:17-alpine` image, so an existing data volume can be reused
# as is: set POSTGRES_IMAGE=dirouter/postgres:17-pgvector and recreate the postgres service.
ARG PG_MAJOR=17
FROM postgres:${PG_MAJOR}-alpine AS build
ARG PGVECTOR_VERSION=0.8.0
RUN apk add --no-cache build-base \
  && wget -qO /tmp/pgvector.tar.gz "https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz" \
  && mkdir /tmp/pgvector && tar -xzf /tmp/pgvector.tar.gz -C /tmp/pgvector --strip-components=1 \
  && cd /tmp/pgvector \
  # Portable build: no -march=native, so the image runs on any CPU of the same architecture.
  && make OPTFLAGS="" with_llvm=no \
  && make install with_llvm=no DESTDIR=/out

FROM postgres:${PG_MAJOR}-alpine
COPY --from=build /out/ /
