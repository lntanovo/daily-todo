package authz.user
default allow := false

allow if {
  input.cloudbase.resource_type == "functions"
  input.request.path == "/api/register"
  input.request.method in {"POST", "OPTIONS"}
}
deny contains "function requires administrator access" if {
  input.cloudbase.resource_type == "functions"
  input.subject.auth_type in {"unauthenticated", "anonymous", "anon", "authenticated", "external", "internal"}
  input.request.path != "/api/register"
}
