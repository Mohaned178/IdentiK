import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Serves the dashboard SPA at / with fallback to it for unknown non-API
 * routes (client-side routing). The SPA location is deployment configuration
 * (IDENTIK_SPA_DIST); the default assumes the workspace frontend build sits
 * beside the backend build. Build outputs (JS/CSS) are served as themselves —
 * a fallback-only shell would answer the bundle request with index.html and
 * render a blank page — while everything else falls through to index.html.
 */
@Controller()
export class SpaController {
  private readonly spaIndex = resolve(
    process.env.IDENTIK_SPA_DIST ??
      join(__dirname, '..', '..', '..', 'frontend', 'dist', 'index.html'),
  );
  private readonly spaDir = dirname(this.spaIndex);

  @Get(['/', '*'])
  serve(@Req() req: Request, @Res() res: Response): void {
    if (req.path.startsWith('/api/') || req.path.startsWith('/dev/')) {
      res.status(404).json({ message: 'Not found' });
      return;
    }
    if (!existsSync(this.spaIndex)) {
      res.status(503).send('dashboard build not found');
      return;
    }
    const asset = resolve(this.spaDir, `.${req.path}`);
    if (
      req.path !== '/' &&
      asset.startsWith(this.spaDir + sep) &&
      existsSync(asset) &&
      statSync(asset).isFile()
    ) {
      res.sendFile(asset);
      return;
    }
    res.sendFile(this.spaIndex);
  }
}
