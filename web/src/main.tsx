import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "react-oidc-context";
import { WebStorageStateStore } from "oidc-client-ts";
import "./index.css";
import { App } from "./App";
import { loadConfig, type AppConfig } from "./config";
import { ConfigContext } from "./lib/use-config";
import { installViewportSync } from "./lib/viewport";
import { installServiceWorker } from "./lib/sw-update";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: false } } });

function oidcConfig(cfg: AppConfig) {
  const origin = window.location.origin;
  return {
    authority: cfg.cognitoAuthority,
    client_id: cfg.cognitoClientId,
    redirect_uri: `${origin}/callback`,
    post_logout_redirect_uri: `${origin}/`,
    response_type: "code",
    scope: "openid email profile",
    automaticSilentRenew: true,
    loadUserInfo: false,
    userStore: new WebStorageStateStore({ store: window.localStorage }),
    metadata: {
      issuer: cfg.cognitoAuthority,
      authorization_endpoint: `${cfg.cognitoDomain}/oauth2/authorize`,
      token_endpoint: `${cfg.cognitoDomain}/oauth2/token`,
      userinfo_endpoint: `${cfg.cognitoDomain}/oauth2/userInfo`,
      end_session_endpoint: `${cfg.cognitoDomain}/logout`,
      revocation_endpoint: `${cfg.cognitoDomain}/oauth2/revoke`,
      jwks_uri: `${cfg.cognitoAuthority}/.well-known/jwks.json`,
    },
    onSigninCallback: () => {
      window.history.replaceState({}, document.title, "/");
    },
  };
}

async function bootstrap() {
  installViewportSync();
  installServiceWorker();
  const root = createRoot(document.getElementById("root")!);
  try {
    const cfg = await loadConfig();
    root.render(
      <StrictMode>
        <ConfigContext.Provider value={cfg}>
          <AuthProvider {...oidcConfig(cfg)}>
            <QueryClientProvider client={queryClient}>
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </QueryClientProvider>
          </AuthProvider>
        </ConfigContext.Provider>
      </StrictMode>,
    );
  } catch (err) {
    root.render(<div className="p-6 text-danger">설정을 불러오지 못했습니다: {String(err)}</div>);
  }
}

void bootstrap();
