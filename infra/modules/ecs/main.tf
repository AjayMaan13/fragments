# The execution role's managed policy can write to a log group but not create
# one, so we create it here. 7-day retention keeps CloudWatch costs near zero.
resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${var.project_name}-task"
  retention_in_days = 7
}

resource "aws_ecs_cluster" "this" {
  name = "${var.project_name}-cluster"
}

resource "aws_ecs_task_definition" "this" {
  family                   = "${var.project_name}-task"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  # ECS wants this as a JSON string; jsonencode() turns HCL data into JSON.
  container_definitions = jsonencode([
    {
      name      = "${var.project_name}-container"
      image     = var.image
      essential = true

      portMappings = [
        {
          containerPort = var.container_port
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = tostring(var.container_port) },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "AWS_S3_BUCKET_NAME", value = var.s3_bucket_name },
        { name = "AWS_DYNAMODB_TABLE_NAME", value = var.dynamodb_table_name },
        { name = "API_URL", value = var.api_url },
        { name = "FRAGMENTS_LOG_LEVEL", value = "info" },
        { name = "AWS_COGNITO_POOL_ID", value = var.cognito_pool_id },
        { name = "AWS_COGNITO_CLIENT_ID", value = var.cognito_client_id },
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
  name            = "${var.project_name}-service"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [var.security_group_id]
    assign_public_ip = true # no NAT gateway, so tasks need a public IP to reach ECR
  }

  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = "${var.project_name}-container"
    container_port   = var.container_port
  }

  # The CD pipeline registers a new task definition revision on every release;
  # without this, `terraform apply` would roll the service back to Terraform's.
  lifecycle {
    ignore_changes = [task_definition]
  }
}
