{
 servers {
  trusted_proxies static private_ranges
 }
}
# 部署换版本、重启时上游有几秒连不上：20 秒内每 250ms 再连一次（只在没连上时重试，POST 不会重复写入）。
(retry_restart) {
 lb_try_duration 20s
 lb_try_interval 250ms
}
:80 {
 encode /m2/* gzip
 redir /m2 /m2/ 308
 reverse_proxy /m2/* m2:4333 {
  flush_interval -1
  transport http {
   response_header_timeout 600s
  }
 }
 reverse_proxy /api/* api:4000 {
  flush_interval -1
  import retry_restart
 }
 reverse_proxy /mcp/* api:4000 {
  import retry_restart
 }
 reverse_proxy /.well-known/oauth-* api:4000 {
  import retry_restart
 }
 reverse_proxy /* web:3000 {
  import retry_restart
 }
}
