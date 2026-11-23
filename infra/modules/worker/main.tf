# The queue worker: the same Docker image as the API, started with
# `node src/worker.js`, as its own ECS service with no load balancer. Keeping
# conversions off the API's task is the point: heavy work can no longer starve
# request handling.

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${var.project_name}-worker-task"
  retention_in_days = 7
}

resource "aws_ecs_task_definition" "this" {
  family                   = "${var.project_name}-worker-task"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name      = "${var.project_name}-worker-container"
      image     = var.image
      essential = true
      command   = ["node", "src/worker.js"]

      # On a deploy ECS sends SIGTERM, then SIGKILL after this many seconds. The
      # worker finishes its current job first, so allow time for a slow one.
      stopTimeout = 120

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "AWS_S3_BUCKET_NAME", value = var.s3_bucket_name },
        { name = "AWS_DYNAMODB_TABLE_NAME", value = var.dynamodb_table_name },
        { name = "AWS_DYNAMODB_JOBS_TABLE_NAME", value = var.jobs_table_name },
        { name = "AWS_SQS_QUEUE_URL", value = var.queue_url },
        { name = "AWS_DYNAMODB_EMBEDDINGS_TABLE_NAME", value = var.embeddings_table_name },
        { name = "FRAGMENTS_LOG_LEVEL", value = "info" },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.this.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "this" {
  name            = "${var.project_name}-worker-service"
  cluster         = var.cluster_id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [var.security_group_id]
    assign_public_ip = true # no NAT gateway, so tasks need a public IP to reach ECR/SQS/S3
  }

  # Like the API service: CD registers a new task definition revision per release
  lifecycle {
    ignore_changes = [task_definition]
  }
}
