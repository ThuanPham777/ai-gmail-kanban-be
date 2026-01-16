import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  getHello() {
    return {
      message: 'AI Gmail Kanban API is running',
      status: 'OK',
      version: '1.0.0',
      endpoints: {
        health: '/health',
        auth: '/api/auth',
        mail: '/api',
        kanban: '/api/kanban',
        gmail: '/api/gmail',
      },
    };
  }

  @Get('ping')
  ping() {
    return {
      message: 'pong',
      timestamp: new Date().toISOString(),
    };
  }
}
