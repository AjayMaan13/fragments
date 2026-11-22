# Observability: one CloudWatch dashboard, four alarms, one SNS topic.
# Everything here is destroyed with the rest of the stack (no retained data
# besides CloudWatch's own metric history, which expires on its own).

locals {
  lb_dim = ["LoadBalancer", var.alb_arn_suffix]
  tg_dim = ["TargetGroup", var.target_group_arn_suffix, "LoadBalancer", var.alb_arn_suffix]
  ecs_dim = [
    "ClusterName", var.ecs_cluster_name,
    "ServiceName", var.ecs_service_name,
  ]
}

###############################################################################
# Alarm notifications
###############################################################################

resource "aws_sns_topic" "alarms" {
  name = "${var.project_name}-alarms"
}

# Email subscriptions start "pending confirmation" until the recipient clicks
# the link AWS sends. Terraform can create it but can't confirm it.
resource "aws_sns_topic_subscription" "email" {
  count = var.alarm_email == "" ? 0 : 1

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

###############################################################################
# Alarms. treat_missing_data = notBreaching everywhere: the stack is torn down
# between sessions and idle most of the time, and "no traffic" is not a failure.
###############################################################################

# 5xx *rate*, not count, so it scales with traffic. The IF() ignores minutes
# with only a handful of requests. FILL(..., 0) because CloudWatch publishes no
# datapoint at all for a metric that is zero.
resource "aws_cloudwatch_metric_alarm" "error_rate" {
  alarm_name          = "${var.project_name}-5xx-rate"
  alarm_description   = "More than ${var.error_rate_threshold_percent}% of requests are failing with a 5xx from the app (min ${var.min_requests_for_error_rate} requests/minute)."
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.error_rate_threshold_percent
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]

  metric_query {
    id          = "requests"
    return_data = false
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      period      = 60
      stat        = "Sum"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
    }
  }

  metric_query {
    id          = "errors"
    return_data = false
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      period      = 60
      stat        = "Sum"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
    }
  }

  metric_query {
    id          = "rate"
    label       = "5xx rate (%)"
    expression  = "IF(requests > ${var.min_requests_for_error_rate}, 100 * FILL(errors, 0) / requests, 0)"
    return_data = true
  }
}

resource "aws_cloudwatch_metric_alarm" "latency_p95" {
  alarm_name          = "${var.project_name}-p95-latency"
  alarm_description   = "p95 target response time is above ${var.p95_latency_threshold_seconds}s."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = { LoadBalancer = var.alb_arn_suffix }
  extended_statistic  = "p95"
  period              = 60
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.p95_latency_threshold_seconds
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# Alarm on UnHealthyHostCount, not "HealthyHostCount < 1": with desired_count = 0
# there are no healthy hosts by design and that must not page anyone.
resource "aws_cloudwatch_metric_alarm" "unhealthy_hosts" {
  alarm_name          = "${var.project_name}-unhealthy-hosts"
  alarm_description   = "At least one target is failing load balancer health checks."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { TargetGroup = var.target_group_arn_suffix, LoadBalancer = var.alb_arn_suffix }
  statistic           = "Maximum"
  period              = 60
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  evaluation_periods  = 2
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# The task has 512 MB and sharp decodes images in-process, so memory is the
# resource most likely to run out first (see docs/perf/baseline.md, experiment 3).
resource "aws_cloudwatch_metric_alarm" "ecs_memory" {
  alarm_name          = "${var.project_name}-ecs-memory"
  alarm_description   = "ECS service memory utilization is above ${var.memory_threshold_percent}%."
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  dimensions          = { ClusterName = var.ecs_cluster_name, ServiceName = var.ecs_service_name }
  statistic           = "Average"
  period              = 60
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.memory_threshold_percent
  evaluation_periods  = 2
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

###############################################################################
# Dashboard
###############################################################################

resource "aws_cloudwatch_dashboard" "this" {
  dashboard_name = "${var.project_name}-overview"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "text"
        x      = 0
        y      = 0
        width  = 24
        height = 3
        properties = {
          markdown = join("\n", [
            "## ${var.project_name} service levels",
            "**SLI 1 - availability:** share of requests that do not get a 5xx from the app (`HTTPCode_Target_5XX_Count` / `RequestCount`).  ",
            "**SLI 2 - latency:** p95 `TargetResponseTime` of cheap reads (measured per request type by the k6 runs in `perf/`; the ALB metric below mixes in conversions).  ",
            "Targets are set from `docs/perf/baseline.md`, and apply only while the stack is up: the stack is destroyed between sessions, so this reports error rate and latency under a stated load, never an uptime percentage.",
          ])
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 3
        width  = 12
        height = 6
        properties = {
          title   = "Requests per minute"
          view    = "timeSeries"
          stacked = false
          region  = var.aws_region
          period  = 60
          stat    = "Sum"
          metrics = [concat(["AWS/ApplicationELB", "RequestCount"], local.lb_dim, [{ label = "requests" }])]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 3
        width  = 12
        height = 6
        properties = {
          title   = "5xx responses per minute"
          view    = "timeSeries"
          stacked = false
          region  = var.aws_region
          period  = 60
          stat    = "Sum"
          metrics = [
            concat(["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count"], local.lb_dim, [{ label = "from the app (target)" }]),
            concat(["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count"], local.lb_dim, [{ label = "from the load balancer" }]),
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 9
        width  = 12
        height = 6
        properties = {
          title   = "Target response time (seconds)"
          view    = "timeSeries"
          stacked = false
          region  = var.aws_region
          period  = 60
          metrics = [
            concat(["AWS/ApplicationELB", "TargetResponseTime"], local.lb_dim, [{ stat = "p50", label = "p50" }]),
            concat(["AWS/ApplicationELB", "TargetResponseTime"], local.lb_dim, [{ stat = "p95", label = "p95" }]),
            concat(["AWS/ApplicationELB", "TargetResponseTime"], local.lb_dim, [{ stat = "p99", label = "p99" }]),
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 9
        width  = 12
        height = 6
        properties = {
          title   = "Target health"
          view    = "timeSeries"
          stacked = false
          region  = var.aws_region
          period  = 60
          stat    = "Maximum"
          metrics = [
            concat(["AWS/ApplicationELB", "HealthyHostCount"], local.tg_dim, [{ label = "healthy" }]),
            concat(["AWS/ApplicationELB", "UnHealthyHostCount"], local.tg_dim, [{ label = "unhealthy" }]),
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 15
        width  = 12
        height = 6
        properties = {
          title   = "ECS CPU and memory utilization (%)"
          view    = "timeSeries"
          stacked = false
          region  = var.aws_region
          period  = 60
          stat    = "Average"
          yAxis   = { left = { min = 0, max = 100 } }
          metrics = [
            concat(["AWS/ECS", "CPUUtilization"], local.ecs_dim, [{ label = "CPU" }]),
            concat(["AWS/ECS", "MemoryUtilization"], local.ecs_dim, [{ label = "memory" }]),
          ]
          annotations = {
            horizontal = [{ label = "memory alarm", value = var.memory_threshold_percent }]
          }
        }
      },
      {
        # Custom metric written by src/metrics.js as EMF log lines. SEARCH finds
        # whichever target types have been converted, so no list to maintain.
        type   = "metric"
        x      = 12
        y      = 15
        width  = 12
        height = 6
        properties = {
          title   = "Conversion duration p95 by target type (ms)"
          view    = "timeSeries"
          stacked = false
          region  = var.aws_region
          period  = 60
          metrics = [
            [{ expression = "SEARCH('{Fragments,TargetType} MetricName=\"ConversionDuration\"', 'p95', 60)", id = "conv" }]
          ]
        }
      },
      {
        type   = "log"
        x      = 0
        y      = 21
        width  = 24
        height = 6
        properties = {
          title  = "Recent errors (pino level >= 50)"
          view   = "table"
          region = var.aws_region
          query  = "SOURCE '${var.log_group_name}' | fields @timestamp, msg, err.message, req.id | filter level >= 50 | sort @timestamp desc | limit 20"
        }
      },
    ]
  })
}
