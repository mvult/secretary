env "neon" {
  url = getenv("DATABASE_URL")
  migration {
    dir = "file://migrations"
    revisions_schema = "public"
  }
}
