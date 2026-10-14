{
 servers {
  trusted_proxies static private_ranges
 }
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
 }
 reverse_proxy /mcp/* api:4000
 reverse_proxy /.well-known/oauth-* api:4000
 reverse_proxy /* web:3000
}
