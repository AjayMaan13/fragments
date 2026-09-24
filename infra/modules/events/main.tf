data "archive_file" "lambda" {
  type        = "zip"
  source_file = "${path.module}/lambda/index.js"
  output_path = "${path.module}/lambda.zip"
}

data "aws_iam_policy_document" "assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = "${var.project_name}-expired-cleanup-role"
  assume_role_policy = data.aws_iam_policy_document.assume_role.json
}

# AWS-managed policy: read from a DynamoDB stream and write logs
resource "aws_iam_role_policy_attachment" "stream_and_logs" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaDynamoDBExecutionRole"
}

resource "aws_iam_role_policy" "delete_fragment_data" {
  name = "${var.project_name}-delete-fragment-data"
  role = aws_iam_role.this.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "s3:DeleteObject"
      Resource = "${var.bucket_arn}/*"
    }]
  })
}

# Created here so it has a retention limit and is removed on destroy
resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${var.project_name}-expired-cleanup"
  retention_in_days = 7
}

resource "aws_lambda_function" "this" {
  function_name    = "${var.project_name}-expired-cleanup"
  role             = aws_iam_role.this.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = 10

  environment {
    variables = {
      BUCKET_NAME = var.bucket_name
    }
  }

  depends_on = [aws_cloudwatch_log_group.this]
}

# Only deletions made by DynamoDB itself (TTL expiry) reach the function.
# When the API deletes a fragment it already removes the S3 data.
resource "aws_lambda_event_source_mapping" "expired_fragments" {
  event_source_arn  = var.stream_arn
  function_name     = aws_lambda_function.this.arn
  starting_position = "LATEST"

  filter_criteria {
    filter {
      pattern = jsonencode({
        eventName = ["REMOVE"]
        userIdentity = {
          type        = ["Service"]
          principalId = ["dynamodb.amazonaws.com"]
        }
      })
    }
  }
}
