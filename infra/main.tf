module "ecr" {
  source = "./modules/ecr"

  project_name = var.project_name
}

module "storage" {
  source = "./modules/storage"

  project_name = var.project_name
}

module "iam" {
  source = "./modules/iam"

  project_name = var.project_name
  bucket_arn   = module.storage.bucket_arn
  table_arn    = module.storage.table_arn
}

module "network" {
  source = "./modules/network"

  project_name   = var.project_name
  container_port = var.container_port
}

module "alb" {
  source = "./modules/alb"

  project_name      = var.project_name
  vpc_id            = module.network.vpc_id
  subnet_ids        = module.network.subnet_ids
  security_group_id = module.network.alb_security_group_id
  container_port    = var.container_port
}

module "auth" {
  source = "./modules/auth"

  project_name  = var.project_name
  callback_urls = var.ui_callback_urls
}

module "ecs" {
  source = "./modules/ecs"

  project_name        = var.project_name
  aws_region          = var.aws_region
  image               = "${module.ecr.repository_url}:latest"
  container_port      = var.container_port
  desired_count       = var.desired_count
  execution_role_arn  = module.iam.task_execution_role_arn
  task_role_arn       = module.iam.task_role_arn
  subnet_ids          = module.network.subnet_ids
  security_group_id   = module.network.ecs_security_group_id
  target_group_arn    = module.alb.target_group_arn
  s3_bucket_name      = module.storage.bucket_name
  dynamodb_table_name = module.storage.table_name
  api_url             = "http://${module.alb.dns_name}"
  cognito_pool_id     = module.auth.user_pool_id
  cognito_client_id   = module.auth.client_id
}
