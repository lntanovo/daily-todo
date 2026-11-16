package authz.user
default allow := false

# 一次性完成链接：只允许从提醒消息里打开的 GET。
# Token 是 32 字节随机数的 sha256 原文，函数内校验有效期与使用状态。
allow if {
  input.cloudbase.resource_type == "functions"
  input.request.path == "/api/register"
  input.request.method in {"POST", "OPTIONS"}
}

allow if {
  input.cloudbase.resource_type == "functions"
  input.request.path == "/api/reminder/done"
  input.request.method in {"GET", "OPTIONS"}
}

allow if {
  input.cloudbase.resource_type == "functions"
  startswith(input.request.path, "/api/reminder/device")
  input.request.method in {"POST", "OPTIONS"}
}

deny contains "function requires administrator access" if {
  input.cloudbase.resource_type == "functions"
  input.subject.auth_type in {"unauthenticated", "anonymous", "anon", "authenticated", "external", "internal"}
  not input.request.path in {"/api/register", "/api/reminder/done"}
  not startswith(input.request.path, "/api/reminder/device")
}
