# Trust policy: only the ECS tasks service is allowed to assume these roles
data "aws_iam_policy_document" "ecs_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# What ECS itself needs: pull the image from ECR, write logs to CloudWatch.
# Runs before your application code starts.
resource "aws_iam_role" "task_execution_role" {
  name               = "${var.project_name}-task-execution-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
}

resource "aws_iam_role_policy_attachment" "execution_role_policy" {
  role       = aws_iam_role.task_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# What your running application is allowed to touch (S3 bucket, DynamoDB
# table).
resource "aws_iam_role" "task_role" {
  name               = "${var.project_name}-task-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
}

# Least privilege: only the operations the app performs, only on our bucket/table.
data "aws_iam_policy_document" "task_data_access" {
  statement {
    sid       = "FragmentObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${var.bucket_arn}/*"]
  }

  # Without ListBucket, S3 answers a read of a missing key with 403 instead of 404.
  statement {
    sid       = "FragmentBucketList"
    actions   = ["s3:ListBucket"]
    resources = [var.bucket_arn]
  }

  statement {
    sid = "FragmentMetadataTable"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
    ]
    resources = [var.table_arn]
  }
}

resource "aws_iam_role_policy" "task_data_access" {
  name   = "${var.project_name}-task-data-access"
  role   = aws_iam_role.task_role.id
  policy = data.aws_iam_policy_document.task_data_access.json
}
