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
# table). Left with no permissions attached here on purpose — Phase 2 adds
# an aws_iam_role_policy scoped to the exact bucket/table ARNs once those
# resources exist.
resource "aws_iam_role" "task_role" {
  name               = "${var.project_name}-task-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
}
