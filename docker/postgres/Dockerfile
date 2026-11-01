# The test PostgreSQL, with HypoPG (indexes the planner assumes, not built) installed as a package. The extension
# itself is made in a database by whoever uses it (the conformance and E2E tests), so the fixtures stay plain SQL.
FROM postgres:17
RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends postgresql-17-hypopg \
  && apt-get clean
