export type AppEnvironment = 'development' | 'preview' | 'production';
export interface MobileConfig {
  environment: AppEnvironment;
  apiOrigin: string;
  supabaseUrl: string;
  supabaseKey: string;
  callbackUrl: string;
}

