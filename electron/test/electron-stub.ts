// Заглушка модуля electron для запуска логики main-процесса из node (тесты, отладочные скрипты)
import { join } from 'node:path';
export const app = {
  isPackaged: false,
  getAppPath: () => process.cwd(),
  getPath: (_: string) => join(process.cwd(), '.tmp-userdata'),
};
