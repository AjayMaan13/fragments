variable "project_name" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "alb_arn_suffix" {
  description = "Load balancer ARN suffix, e.g. app/fragments-lb/50dc6c495c0c9188 (the CloudWatch LoadBalancer dimension)"
  type        = string
}

variable "target_group_arn_suffix" {
  description = "Target group ARN suffix, e.g. targetgroup/fragments-tg/73e2d6bc24d8a067 (the CloudWatch TargetGroup dimension)"
  type        = string
}

variable "ecs_cluster_name" {
  type = string
}

variable "ecs_service_name" {
  type = string
}

variable "log_group_name" {
  description = "CloudWatch log group the API container writes to (for the recent-errors widget)"
  type        = string
}

variable "alarm_email" {
  description = "Email address to notify when an alarm fires. Empty = create the alarms but no subscription. AWS emails a confirmation link you must click."
  type        = string
  default     = ""
}

# These alarm thresholds are deliberately generous first guesses. Tighten them
# once docs/perf/baseline.md says what the service actually does.
variable "error_rate_threshold_percent" {
  description = "Alarm when more than this % of requests get a 5xx from the app"
  type        = number
  default     = 5
}

variable "min_requests_for_error_rate" {
  description = "Ignore the error-rate alarm unless a minute has more requests than this (1 failure in 3 requests is not an incident)"
  type        = number
  default     = 20
}

variable "p95_latency_threshold_seconds" {
  description = "Alarm when p95 target response time (all requests, incl. conversions) exceeds this"
  type        = number
  default     = 3
}

variable "memory_threshold_percent" {
  description = "Alarm when ECS service memory utilization exceeds this %"
  type        = number
  default     = 80
}
