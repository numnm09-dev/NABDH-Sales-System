const { ExternalAccountClient } = require('google-auth-library');

let adminPromise;

async function getFirebaseAdmin() {
  if (adminPromise) return adminPromise;

  adminPromise = (async () => {
    const required = [
      'GCP_PROJECT_ID',
      'GCP_PROJECT_NUMBER',
      'GCP_SERVICE_ACCOUNT_EMAIL',
      'GCP_WORKLOAD_IDENTITY_POOL_ID',
      'GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID'
    ];

    const missing = required.filter(name => !process.env[name]);
    if (missing.length) {
      throw new Error(`missing_config:${missing.join(',')}`);
    }

    const { getVercelOidcToken } = await import('@vercel/oidc');

    const authClient = ExternalAccountClient.fromJSON({
      type: 'external_account',
      audience:
        `//iam.googleapis.com/projects/${process.env.GCP_PROJECT_NUMBER}` +
        `/locations/global/workloadIdentityPools/${process.env.GCP_WORKLOAD_IDENTITY_POOL_ID}` +
        `/providers/${process.env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID}`,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      token_url: 'https://sts.googleapis.com/v1/token',
      service_account_impersonation_url:
        `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/` +
        `${process.env.GCP_SERVICE_ACCOUNT_EMAIL}:generateAccessToken`,
      subject_token_supplier: {
        getSubjectToken: () => getVercelOidcToken()
      }
    });

    if (!authClient) {
      throw new Error('auth_client_unavailable');
    }

    const credential = {
      async getAccessToken() {
        const result = await authClient.getAccessToken();

        if (!result || !result.token) {
          throw new Error('google_access_token_unavailable');
        }

        return {
          access_token: result.token,
          expires_in: 3600
        };
      }
    };

    const { initializeApp, getApps } = require('firebase-admin/app');
    const { getAuth } = require('firebase-admin/auth');
    const { getDatabase } = require('firebase-admin/database');

    const app = getApps().find(item => item.name === 'nabdh-admin') ||
      initializeApp({
        credential,
        projectId: process.env.GCP_PROJECT_ID,
        databaseURL: 'https://nabdh-erp-default-rtdb.firebaseio.com'
      }, 'nabdh-admin');

    return {
      app,
      auth: getAuth(app),
      database: getDatabase(app)
    };
  })().catch(error => {
    adminPromise = null;
    throw error;
  });

  return adminPromise;
}

module.exports = { getFirebaseAdmin };
