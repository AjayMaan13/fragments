# S3 bucket names are unique across ALL AWS accounts worldwide, so we
# append the account ID to make ours unique without guessing.
data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "fragments" {
  bucket = "${var.project_name}-data-${data.aws_caller_identity.current.account_id}"

  # Lets `terraform destroy` delete the bucket even if it still has fragment
  # objects in it. Without this, destroy fails on a non-empty bucket.
  force_destroy = true
}

# Fragment data is private. Share links (Phase 6) use pre-signed URLs, which
# keep working with all public access blocked.
resource "aws_s3_bucket_public_access_block" "fragments" {
  bucket = aws_s3_bucket.fragments.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "fragments" {
  name         = var.project_name
  billing_mode = "PAY_PER_REQUEST"

  # Same key schema the app already uses: all of a user's fragments share
  # a partition key (ownerId); each fragment is one item within it (id).
  hash_key  = "ownerId"
  range_key = "id"

  attribute {
    name = "ownerId"
    type = "S"
  }

  attribute {
    name = "id"
    type = "S"
  }

  # Emits an event for every change, so the events module can react when
  # DynamoDB deletes an expired fragment. Keys are all it needs to find the S3 file.
  stream_enabled   = true
  stream_view_type = "KEYS_ONLY"

  # Items with an `expiresAt` attribute (a Number: Unix epoch seconds) are
  # deleted automatically by DynamoDB some time after that moment passes.
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}
