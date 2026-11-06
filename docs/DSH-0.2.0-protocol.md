# DSH 0.2.0-rc.2 线协议规格(桥适配契约)

> 2026-09-29/30 沙箱实测逆向,全部帧均已活体验证(沙箱 3090)。
> 用途:qq-bridge dsh-client.js 与 quest dsh-client-v2.mjs 的 0.2.0 适配。

## 1. 鉴权(token→cookie,强制)

- token 来源:进程 stdout 的 `dsh web: http://host:port/?token=<T>` 行(同 0.1.2+,v2 客户端已有解析逻辑,复用)。
- 交换:`GET /?token=<T>` → `303` + `Set-Cookie`(HttpOnly,30 天)。
- 所有 `/api` POST 与 WS 升级都要带 cookie。WS 的 query token **无效**,必须 cookie 头。
- 401 时重新解析 token(DSH 重启会换)+ 重交换。

## 2. 一元 RPC

- 路由:`POST /api/<method>`,method 用**斜杠**(`session/list`,不再是 `session.list`)。
- 请求信封:`{type:'client-request', rpcId:<uuid>, method:'session/prompt', payload:{args:{<wire>:<参数对象>}}}`
- 应答信封:`{type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error:{code,message,details}}}`(result 形状与 0.1.5 unwrap 兼容)
- **wire 键名**(session 控制器实测):
  - `session/list` → `_request`(特例)
  - `session/{create,prompt,cancel,updateQueue,selectModel,rename,fork,attachment,follow,search,page,projections,openWorkspacePath,workspacePathApplications}` → `request`
  - 无参:`session/{modelCatalog,control,initializeDefaultModel,canOpenWorkspacePath}`
- value 形状变化:`session/list` → `{items:[...]}`(0.1.5 是别的形状,桥的 zod 层需绕过)
- 新方法(桥可用):`userQuestions/answer`(args: {answers:[{id,selected,custom?}]} → boolean)

## 3. 事件载波:WS `/api/remote.mux`(events.mux/events.host 已退役)

客户端→服务端帧(文本 JSON,键必须恰好齐全):
- `{type:'open', streamId, endpoint, payload:{args:{...}}}` — 开一条逻辑流
- `{type:'item', streamId, value}` / `{type:'end', streamId}` / `{type:'cancel', streamId}`

服务端→客户端帧:
- `{type:'item', streamId, value}` / `{type:'error', streamId, error}` / (end)

### 3a. 全局事件流:endpoint `$events`

- open:`{type:'open', streamId:'ev1', endpoint:'$events', payload:{args:{}}}`(args 必须恰为空对象)
- 首帧:`{type:'item', streamId, value:{type:'ready', clientId:<uuid>, host:{home}}}` — **记下 clientId,应答要用**
- 事件帧:`{type:'item', streamId, value:{type:'emit', event:'<名>', args:[...]}}`
- 27 个转发事件(实测倾倒):api-session/{added,removed,status,error,activity}、approval/request(**waterfall**)、user-questions/request(**waterfall**)、deepseek-account/*、settings/*、plugin-manager/*、cordis/*、llm/adapters-updated、goal/*、schedule/changed、commands/change、credentials/*、agent-preset/selected、permission-presets/*
- **waterfall 事件需要应答续流**:`POST /api/$events/result` body={type:'client-request',rpcId,method:'$events/result',payload:{args:{request:{clientId, eventId, outcome:{kind:'next'}}}}}(应答 value 可带答案;eventId 在 waterfall 事件帧里携带——桥侧收到先 ack next,答案流后续接)

### 3b. 每会话事件流:endpoint `session/follow`(短名,不带包前缀!)

- open:`{type:'open', streamId:'f1', endpoint:'session/follow', payload:{args:{request:{address:{kind:'session', sessionId}}}}}`
- 首帧 snapshot:`value:{type:'snapshot', header:{version:4,id,createdAt,cwd,agentPreset}, cursor, records:[{type:'event', event:{...}}...], hasMore, projections}`
- 后续:`value:{type:'event', event:{...会话事件(turn/start, assistant/message, turn/end 同旧词汇表)...}}` 与 `{type:'assistant-stream', frame}`(可选,不开 assistantStream 就没有)
- **turn 收集器(createTurnCollector)可直接复用**——event 形状同旧 session/event

## 4. 桥的适配架构(dual dialect)

- 方言探测:启动时先试斜杠 `session/list`,失败退点号,缓存结果(0.1.5 生产 / 0.2.0 升级后自动切)
- 0.2.0 分支:NodeApiClient 不再走 AbstractApiClient 的 zod 层,直接实现 10 个在用方法
  (sessions.prompt/create/selectModel, workspace.archiveSession/rename/create/list/delete, host.describe + list)
- 事件:0.2.0 下 openMux = remote.mux + $events(全局)+ 每个映射会话一条 session/follow 流;
  旧 envelope 消费面(bridge.js 7980 起)在适配层合成相同形状,或小改消费循环
- bridge.js 调用面(实测统计):sessions.prompt×5, workspace.archiveSession×4, sessions.create×3, workspace.{rename,create,list,delete}, sessions.selectModel, host.describe

## 5. 待补(实现时顺手)

- workspace.* / host.describe 的 0.2.0 wire 名(从对应控制器包 typert.remote-client 同法提取)
- waterfall 事件帧里 eventId 的确切字段名(触发一次 approval 实测)
- 沙箱靶:3090(重新拉起:`cd C:/Users/Solanine/dsh-020test && DSH_HOME=C:/Users/Solanine/.dsh-020home node node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3090 --no-open`,日志 /tmp/dsh020-run2.log 取 token)
