declare module '@koa/cors' {
  import { Middleware } from 'koa';
  interface CorsOptions {
    origin?: string | ((ctx: any) => string);
    allowMethods?: string | string[];
    allowHeaders?: string | string[];
    exposeHeaders?: string | string[];
    maxAge?: number | string;
    credentials?: boolean | ((ctx: any) => boolean);
    keepHeadersOnError?: boolean;
    secureContext?: boolean;
    privateNetworkAccess?: boolean;
  }
  function cors(options?: CorsOptions): Middleware;
  export default cors;
}
