import { createAPI } from '@secretary/api';
import { getToken } from './auth';

const isDev = import.meta.env.MODE === 'development';
export const baseUrl = import.meta.env.VITE_API_URL || (isDev ? 'http://localhost:8091' : '/');

const api = createAPI({ baseUrl, getToken });
export const recordingsClient = api.recordings;
export const todosClient = api.todos;
export const usersClient = api.users;
