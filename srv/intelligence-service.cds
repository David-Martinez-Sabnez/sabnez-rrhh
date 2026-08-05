@path: '/intelligence'
service IntelligenceService {

  type AssistantContext {
    source         : String(50);
    appId          : String(150);
    appName        : String(150);
    semanticObject : String(100);
    action         : String(100);
    route          : String(500);
    entity         : String(150);
    recordId       : String(150);
  }

  type AssistantResponse {
    message        : LargeString;
    conversationId : UUID;
    responseType   : String(30);
    payload        : LargeString;
  }

  action sendMessage(
    message        : LargeString,
    conversationId : UUID,
    context        : AssistantContext
  ) returns AssistantResponse;
}
