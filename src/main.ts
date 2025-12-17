import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const config = app.get(ConfigService);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strips unknown fields
      forbidNonWhitelisted: true, // 400 if unknown provided
      transform: true,
    }),
  );

  app.enableCors({
    origin: config.get<string>('CORS_ORIGIN') || true,
    credentials: true,
  });

  // Memory monitoring & optional GC (production)
  if (process.env.NODE_ENV === 'production') {
    // Attempt to run GC periodically when exposed via --expose-gc
    if (typeof (global as any).gc === 'function') {
      setInterval(() => {
        try {
          (global as any).gc();
        } catch (e) {
          // ignore
        }
      }, 30 * 1000); // every 30s
    }

    // Monitor memory every minute and exit if dangerously high
    setInterval(() => {
      const used = process.memoryUsage();
      const heapMB = Math.round(used.heapUsed / 1024 / 1024);
      const totalMB = Math.round(used.heapTotal / 1024 / 1024);
      console.log(
        `[Memory] Heap: ${heapMB}MB / ${totalMB}MB (RSS: ${Math.round(used.rss / 1024 / 1024)}MB)`,
      );

      if (heapMB > 700) {
        console.error(
          '[Memory] CRITICAL: heap exceeded 700MB, exiting to allow restart',
        );
        process.exit(1);
      }

      if (heapMB > 600) {
        console.warn(`[Memory] WARNING: High memory usage: ${heapMB}MB`);
        try {
          if (typeof (global as any).gc === 'function') (global as any).gc();
        } catch {}
      }
    }, 60 * 1000);
  }

  const port = config.get<number>('PORT') || 4000;
  await app.listen(port);
  console.log(`API running on http://localhost:${port}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

  // Log initial memory
  const initial = process.memoryUsage();
  console.log(`Initial heap: ${Math.round(initial.heapUsed / 1024 / 1024)}MB`);
}
bootstrap();
