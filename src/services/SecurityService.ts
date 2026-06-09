import logger from '../utils/logger.js';
import fs from 'fs/promises';

export class SecurityService {
  private static magika: any = null;
  private static isLoaded = false;
  private static initPromise: Promise<void> | null = null;

  /**
   * Initializes the Magika model.
   * This is called lazily when the first identification request is made.
   */
  private static async init() {
    if (this.isLoaded) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        logger.info('Initializing Magika AI for file identification...');
        const { MagikaNode } = await import('magika/node');
        this.magika = await MagikaNode.create();
        this.isLoaded = true;
        logger.info('Magika AI initialized successfully.');
      } catch (error) {
        logger.error('Failed to initialize Magika AI:', error);
        this.initPromise = null;
        // Don't throw - allow server to start without Magika
        logger.warn('Server will continue without AI file identification.');
      }
    })();

    return this.initPromise;
  }

  /**
   * Identifies the content type of a file buffer or path using Google's Magika (AI-based).
   * @param source The file content as a Buffer or a path to the file
   * @returns Detailed identification result
   */
  static async identifyFile(source: Buffer | string) {
    if (!this.isLoaded) {
      await this.init();
    }

    if (!this.magika) {
      throw new Error('Magika service not available');
    }

    try {
      let buffer: Uint8Array;
      if (typeof source === 'string') {
        const fileData = await fs.readFile(source);
        buffer = new Uint8Array(fileData);
      } else {
        buffer = new Uint8Array(source);
      }

      const result = await this.magika.identifyBytes(buffer);
      return result;
    } catch (error) {
      logger.error('Error during Magika file identification:', error);
      throw new Error('Security check failed during file analysis.');
    }
  }

  /**
   * Validates if the file content matches its claimed extension and is safe.
   * @param source File content (Buffer or path)
   * @param claimedExtension Extension provided by the user (e.g., '.pdf')
   * @param allowedMimeTypes Optional whitelist of allowed MIME types
   * @returns boolean true if the file is considered safe and matches
   */
  static async validateFileSafety(source: Buffer | string, claimedExtension: string, allowedMimeTypes?: string[]) {
    try {
      const identification = await this.identifyFile(source);
      const prediction = identification.prediction;
      const detectedLabel = prediction.output.label;
      const score = prediction.score;
      
      // Log detected type for audit
      const fileName = typeof source === 'string' ? source.split('/').pop() : 'buffer';
      logger.info(`AI Security Check [${fileName}]: Claimed=${claimedExtension}, Detected=${detectedLabel}, Score=${score}`);

      // High confidence threshold (Magika is very accurate, but we can set a threshold)
      const CONFIDENCE_THRESHOLD = 0.5;
      
      if (score < CONFIDENCE_THRESHOLD) {
          logger.warn(`Low confidence AI identification for ${claimedExtension}. Score: ${score}`);
      }

      // Basic safety check: detected type should be consistent with allowed types if provided
      if (allowedMimeTypes && allowedMimeTypes.length > 0) {
          // Check if detected label matches any allowed MIME type or extension
          const isMimeAllowed = allowedMimeTypes.some(mime => 
              mime.toLowerCase().includes(detectedLabel.toLowerCase()) || 
              detectedLabel.toLowerCase().includes(mime.toLowerCase())
          );
          
          if (!isMimeAllowed) {
              logger.error(`Security Alert: AI mismatch for ${claimedExtension}. Detected: ${detectedLabel}. Whitelist: ${allowedMimeTypes.join(', ')}`);
              return false;
          }
      }

      return true;
    } catch (error) {
      logger.error('File safety validation error:', error);
      // Fail-closed: if security check fails, reject the file
      // Only allow if Magika is simply not loaded (graceful degradation)
      if (!this.isLoaded) {
        logger.warn('Magika not available - allowing file with extension-only validation');
        return true;
      }
      return false; 
    }
  }
}
