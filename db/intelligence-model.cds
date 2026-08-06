namespace sabnez.intelligence;

using {
  cuid,
  managed
} from '@sap/cds/common';

entity Conversations : cuid, managed {
  userId                 : String(255) not null;
  status                 : String(20) default 'ACTIVE';
  title                  : String(255);
  activeGoal             : String(100);
  pendingQuestion        : String(100);
  knownArguments         : LargeString;
  lastContext            : LargeString;
  lastProvider           : String(50);
  lastProviderResponseId : String(255);
  lastMessageAt          : Timestamp;

  messages : Composition of many Messages
    on messages.conversation = $self;
}

entity Messages : cuid, managed {
  conversation : Association to Conversations not null;

  userId       : String(255);
  role         : String(20) not null;
  content      : LargeString not null;
  responseType : String(40);

  toolName     : String(100);
  toolArguments: LargeString;
  toolResult   : LargeString;

  provider     : String(50);
  model        : String(100);
  inputTokens  : Integer default 0;
  outputTokens : Integer default 0;
  totalTokens  : Integer default 0;

  appContext   : LargeString;
  payload      : LargeString;
}
