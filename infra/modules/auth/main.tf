data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# The user directory: who can sign up and log in.
resource "aws_cognito_user_pool" "this" {
  name = "${var.project_name}-users"

  # Users sign in with their email address; the API identifies users by the
  # `email` claim in the ID token.
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  # Lets `terraform destroy` remove the pool.
  deletion_protection = "INACTIVE"
}

# The hosted login page lives at https://<prefix>.auth.<region>.amazoncognito.com
# The prefix must be unique within the region, so we add the account ID.
resource "aws_cognito_user_pool_domain" "this" {
  domain       = "${var.project_name}-${data.aws_caller_identity.current.account_id}"
  user_pool_id = aws_cognito_user_pool.this.id
}

# One "app" that is allowed to use the pool: the fragments-ui web app.
resource "aws_cognito_user_pool_client" "this" {
  name         = "${var.project_name}-ui"
  user_pool_id = aws_cognito_user_pool.this.id

  # A browser app can't keep a secret, so this is a "public" client that
  # relies on PKCE (which oidc-client-ts does automatically).
  generate_secret = false

  # OAuth 2.0 authorization-code flow through the hosted login page,
  # matching `response_type: 'code'` and the scopes in fragments-ui/src/auth.js.
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "phone"]
  supported_identity_providers         = ["COGNITO"]

  # Cognito only redirects to URLs listed here, character for character.
  callback_urls = var.callback_urls
  logout_urls   = var.callback_urls

  explicit_auth_flows = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]

  prevent_user_existence_errors = "ENABLED"
}
