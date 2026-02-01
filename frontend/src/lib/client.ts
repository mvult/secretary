import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { RecordingsService } from '../gen/secretary/v1/recordings_connect';
import { TodosService } from '../gen/secretary/v1/todos_connect';
import { UsersService } from '../gen/secretary/v1/users_connect';
import { getToken } from './auth';

const transport = createConnectTransport({
  baseUrl: 'http://localhost:8080',
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
