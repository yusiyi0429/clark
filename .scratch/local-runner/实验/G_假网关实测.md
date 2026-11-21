# 假网关实测原始记录（11/06 第二轮）

脚本：同目录 `G_fake-gateway.mjs`（`node G_fake-gateway.mjs <配置.json>`）。S = 实验临时目录（work 是工作目录，outside 是外面的目录）。结论见 RFC 附录 G。

## a

配置：mode=script env={} settings={} hooks=PreToolUse
上下文里有全局规则：true；有仓库 CLAUDE.md：true

```
5380ms hook_callback {"id":"pg","tool":"Read","tool_use_id":"toolu_0"}
5644ms can_use_tool {"tool":"Read","tool_use_id":"toolu_0"}
5705ms tool_result {"id":"toolu_0","err":true,"text":"\"test deny\""}
5790ms hook_callback {"id":"pg","tool":"Bash","tool_use_id":"toolu_1"}
5827ms can_use_tool {"tool":"Bash","tool_use_id":"toolu_1"}
5834ms tool_result {"id":"toolu_1","err":true,"text":"\"test deny\""}
5866ms hook_callback {"id":"pg","tool":"Glob","tool_use_id":"toolu_2"}
5931ms can_use_tool {"tool":"Glob","tool_use_id":"toolu_2"}
5935ms tool_result {"id":"toolu_2","err":true,"text":"\"test deny\""}
5965ms hook_callback {"id":"pg","tool":"Grep","tool_use_id":"toolu_3"}
6023ms can_use_tool {"tool":"Grep","tool_use_id":"toolu_3"}
6026ms tool_result {"id":"toolu_3","err":true,"text":"\"test deny\""}
6305ms hook_callback {"id":"pg","tool":"Read","tool_use_id":"toolu_4"}
6486ms tool_result {"id":"toolu_4","text":"\"1\\tinside\\n2\\t\""}
6570ms hook_callback {"id":"pg","tool":"Bash","tool_use_id":"toolu_5"}
10045ms tool_result {"id":"toolu_5","err":false,"text":"\"CLAUDE.md\\ninside.txt\\nShell cwd was reset to C:\\\\Users\\\\10021\\\\AppData\\\\Local\\\\Temp\\\\claude\\\\5412242dd0cafb0c\\\\1e1fde7b-dbb6-4c7b-a0b3-c7c1a8e61db3\\\\scratchpa"}
10080ms hook_callback {"id":"pg","tool":"Write","tool_use_id":"toolu_6"}
10155ms can_use_tool {"tool":"Write","tool_use_id":"toolu_6"}
10162ms tool_result {"id":"toolu_6","err":true,"text":"\"test deny\""}
10459ms result/success {"sub":"success","is_error":false,"result":"done","api_error_status":null}
```

## b1

配置：mode=script env={} settings={} hooks=无
上下文里有全局规则：true；有仓库 CLAUDE.md：true

```
1893ms can_use_tool {"tool":"Read","tool_use_id":"toolu_0","reason":"Path is outside allowed working directories","rtype":"workingDir","desc":"~\\AppData\\Local\\Temp\\claude\\5412242dd0cafb0c\\1e1fde7b-dbb6-4c7b-a0b3-c7c1a8e61db3\\scratchp
1918ms tool_result {"id":"toolu_0","err":true,"text":"\"test deny\""}
2086ms can_use_tool {"tool":"Bash","tool_use_id":"toolu_1","blocked":"C:\\Users\\10021\\AppData\\Local\\Temp\\claude\\5412242dd0cafb0c\\1e1fde7b-dbb6-4c7b-a0b3-c7c1a8e61db3\\scratchpad\\exp\\outside\\secret.txt","desc":"show","display":"Bas
2130ms tool_result {"id":"toolu_1","err":true,"text":"\"test deny\""}
2223ms can_use_tool {"tool":"Glob","tool_use_id":"toolu_2","reason":"Path is outside allowed working directories","rtype":"workingDir","desc":"*.txt","display":"Glob"}
2231ms tool_result {"id":"toolu_2","err":true,"text":"\"test deny\""}
2337ms result/success {"sub":"success","is_error":false,"result":"done","api_error_status":null}
```

## b2

配置：mode=script env={} settings={} hooks=PreToolUse → ask
上下文里有全局规则：true；有仓库 CLAUDE.md：true

```
1711ms hook_callback {"id":"pg","tool":"Read","tool_use_id":"toolu_0"}
1818ms can_use_tool {"tool":"Read","tool_use_id":"toolu_0","reason":"outside allowed folders","rtype":"hook","desc":"~\\AppData\\Local\\Temp\\claude\\5412242dd0cafb0c\\1e1fde7b-dbb6-4c7b-a0b3-c7c1a8e61db3\\scratchpad\\exp\\outside\\secret.t
1851ms tool_result {"id":"toolu_0","err":true,"text":"\"test deny\""}
1992ms hook_callback {"id":"pg","tool":"Bash","tool_use_id":"toolu_1"}
2023ms can_use_tool {"tool":"Bash","tool_use_id":"toolu_1","reason":"outside allowed folders","rtype":"hook","desc":"show","display":"Bash"}
2040ms tool_result {"id":"toolu_1","err":true,"text":"\"test deny\""}
2074ms hook_callback {"id":"pg","tool":"Glob","tool_use_id":"toolu_2"}
2165ms can_use_tool {"tool":"Glob","tool_use_id":"toolu_2","reason":"outside allowed folders","rtype":"hook","desc":"*.txt","display":"Glob"}
2176ms tool_result {"id":"toolu_2","err":true,"text":"\"test deny\""}
2265ms result/success {"sub":"success","is_error":false,"result":"done","api_error_status":null}
```

## d1

配置：mode=script env={} settings={} hooks=无
上下文里有全局规则：true；有仓库 CLAUDE.md：false

```
1708ms can_use_tool {"tool":"Read","tool_use_id":"toolu_0","reason":"Path is outside allowed working directories","rtype":"workingDir","desc":"~\\AppData\\Local\\Temp\\claude\\5412242dd0cafb0c\\1e1fde7b-dbb6-4c7b-a0b3-c7c1a8e61db3\\scratchp
1729ms tool_result {"id":"toolu_0","err":true,"text":"\"test deny\""}
1799ms can_use_tool {"tool":"Bash","tool_use_id":"toolu_1","blocked":"C:\\Users\\10021\\AppData\\Local\\Temp\\claude\\5412242dd0cafb0c\\1e1fde7b-dbb6-4c7b-a0b3-c7c1a8e61db3\\scratchpad\\exp\\outside\\secret.txt","desc":"show","display":"Bas
1810ms tool_result {"id":"toolu_1","err":true,"text":"\"test deny\""}
1891ms can_use_tool {"tool":"Read","tool_use_id":"toolu_2","reason":"Path is outside allowed working directories","rtype":"workingDir","desc":"~\\.claude\\projects\\x\\SESSIONID\\tool-results\\a.txt","display":"Read"}
1896ms tool_result {"id":"toolu_2","err":true,"text":"\"test deny\""}
1945ms result/success {"sub":"success","is_error":false,"result":"done","api_error_status":null}
```

## c1

配置：mode=script env={} settings={"claudeMdExcludes":["~/.claude/**"]} hooks=无
上下文里有全局规则：false；有仓库 CLAUDE.md：true

```
3053ms result/success {"sub":"success","is_error":false,"result":"done","api_error_status":null}
```

## c2

配置：mode=script env={"CLAUDE_CONFIG_DIR":"C:/Users/10021/AppData/Local/Temp/claude/5412242dd0cafb0c/1e1fde7b-dbb6-4c7b-a0b3-c7c1a8e61db3/scratchpad/exp/cfgdir"} settings={} hooks=无
上下文里有全局规则：true；有仓库 CLAUDE.md：true

```
2166ms result/success {"sub":"success","is_error":false,"result":"done","api_error_status":null}
```

## f1

配置：mode=fail env={"CLAUDE_CODE_MAX_RETRIES":"2"} settings={} hooks=无
上下文里有全局规则：true；有仓库 CLAUDE.md：true

```
1555ms system/api_retry {"sub":"api_retry","attempt":1,"max":2,"delay":598,"status":500,"error":"server_error"}
2182ms system/api_retry {"sub":"api_retry","attempt":2,"max":2,"delay":1100,"status":500,"error":"server_error"}
3302ms result/success {"sub":"success","is_error":true,"result":"API Error: 500 fake down. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:62785).","api_error_sta
```

## f2

配置：mode=refused env={"CLAUDE_CODE_MAX_RETRIES":"2"} settings={} hooks=无
上下文里有全局规则：false；有仓库 CLAUDE.md：false

```
1514ms system/api_retry {"sub":"api_retry","attempt":1,"max":2,"delay":568,"status":null,"error":"unknown"}
2113ms system/api_retry {"sub":"api_retry","attempt":2,"max":2,"delay":1071,"status":null,"error":"unknown"}
3212ms result/success {"sub":"success","is_error":true,"result":"API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)","api_error_status":null}
```

## h1

配置：mode=hang env={"CLAUDE_CODE_MAX_RETRIES":"2","CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS":"20000"} settings={} hooks=无
上下文里有全局规则：true；有仓库 CLAUDE.md：true

```
170084ms timeout_kill {}
```

## h2

配置：mode=hang env={"CLAUDE_CODE_MAX_RETRIES":"2","API_TIMEOUT_MS":"20000"} settings={} hooks=无
上下文里有全局规则：true；有仓库 CLAUDE.md：true

```
21602ms system/api_retry {"sub":"api_retry","attempt":1,"max":2,"delay":587,"status":null,"error":"unknown"}
42199ms system/api_retry {"sub":"api_retry","attempt":2,"max":2,"delay":1002,"status":null,"error":"unknown"}
63250ms result/success {"sub":"success","is_error":true,"result":"Request timed out","api_error_status":null}
```

## s1

配置：mode=slow env={"CLAUDE_CODE_MAX_RETRIES":"2","API_TIMEOUT_MS":"20000"} settings={} hooks=无
上下文里有全局规则：true；有仓库 CLAUDE.md：true

```
51086ms result/success {"sub":"success","is_error":false,"result":"p0 p1 p2 p3 p4 p5 p6 p7 p8 p9 p10 p11 p12 p13 p14 ","api_error_status":null}
```

## s2

配置：mode=stall env={"CLAUDE_CODE_MAX_RETRIES":"2","API_TIMEOUT_MS":"20000"} settings={} hooks=无
上下文里有全局规则：true；有仓库 CLAUDE.md：true

```
324351ms system/api_retry {"sub":"api_retry","attempt":1,"max":1,"delay":624,"status":null,"error":"unknown"}
345391ms result/success {"sub":"success","is_error":true,"result":"Request timed out","api_error_status":null}
```

## s3

配置：mode=stall env={"CLAUDE_CODE_MAX_RETRIES":"2","API_TIMEOUT_MS":"20000","CLAUDE_STREAM_IDLE_TIMEOUT_MS":"30000"} settings={} hooks=无
上下文里有全局规则：true；有仓库 CLAUDE.md：true

```
324792ms system/api_retry {"sub":"api_retry","attempt":1,"max":1,"delay":526,"status":null,"error":"unknown"}
346102ms result/success {"sub":"success","is_error":true,"result":"Request timed out","api_error_status":null}
```
