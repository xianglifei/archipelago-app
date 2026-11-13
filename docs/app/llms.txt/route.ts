import { docsLlms } from '@/lib/source';
import { appName } from '@/lib/shared';

export const revalidate = false;

export async function GET() {
  // llms() 默认用 "# Docs" 作为标题;换成站点名,给 AI 助手一个可引用的正确出处
  const text = await docsLlms.index();
  return new Response(text.replace(/^# Docs\n/, `# ${appName}\n`));
}
