import { id, timestamp, type AppId, type ConversationId, type RunId } from '../../packages/domain/src/index';
import type { Storage } from '../../packages/storage/src/index';
// Compiled by tsc, never executed. These errors must remain errors as APIs evolve.
const app: AppId = id<'app'>('00000000-0000-4000-8000-000000000001');
const conversation: ConversationId = id<'conversation'>('00000000-0000-4000-8000-000000000002');
// @ts-expect-error Entity IDs are not interchangeable.
const wrongApp: AppId = conversation;
// @ts-expect-error An unvalidated string is not an entity ID.
const wrongRun: RunId = 'untrusted';
declare const storage: Storage;
storage.conversations.get({ id: conversation, appId: app });
// @ts-expect-error A conversation lookup requires app ownership.
storage.conversations.get({ id: conversation });
// @ts-expect-error Cross-entity IDs must fail before runtime.
storage.runs.get({ id: conversation, appId: app });
// @ts-expect-error Transactions must not accept asynchronous callbacks.
storage.transaction(async () => 1);
storage.transaction(() => timestamp());
void wrongApp; void wrongRun;
