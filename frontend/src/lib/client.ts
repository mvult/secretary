import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { RecordingsService } from '../gen/secretary/v1/recordings_connect';
import { TodosService } from '../gen/secretary/v1/todos_connect';
import { UsersService } from '../gen/secretary/v1/users_connect';
import { getToken } from './auth';

const isProd = import.meta.env.PROD;
const baseUrl = import.meta.env.VITE_API_URL || (isProd ? '' : 'http://localhost:8080');

const transport = createConnectTransport({
  baseUrl,
  interceptors: [
    (next) => async (req) => {
      const token = getToken();
      if (token) {
        req.header.set('Authorization', `Bearer ${token}`);
      }
      return next(req);
    },
  ],
});

export const recordingsClient = createClient(RecordingsService, transport);
export const todosClient = createClient(TodosService, transport);
export const usersClient = createClient(UsersService, transport);
