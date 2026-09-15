# 新建 apps/web 而不是原地清理旧 frontend

目标前端从空的 `apps/web` 开始，只迁移 CEO WarMap 已确认的布局、CSS Modules、通知浮卡、对象页过渡、文本 Conversation、引用托盘和无障碍交互；旧页面、业务 API、Agent、数据、本体、录音、语音和演示状态不迁移。新 Web 通过稳定对象 URL 和生成的 OpenAPI 客户端消费类型化 Card，验收后删除整个旧 `frontend/`，避免在数百个旧模块中留下隐式业务依赖。