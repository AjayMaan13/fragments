output "dns_name" {
  value = aws_lb.this.dns_name
}

output "target_group_arn" {
  value = aws_lb_target_group.this.arn

  # An ECS service can't attach to a target group until a listener connects
  # that group to the load balancer. Terraform can't see that dependency
  # through a module boundary, so we state it here.
  depends_on = [aws_lb_listener.http]
}

# CloudWatch identifies load balancers and target groups by the tail of their
# ARN, not the full ARN or the name.
output "lb_arn_suffix" {
  value = aws_lb.this.arn_suffix
}

output "target_group_arn_suffix" {
  value = aws_lb_target_group.this.arn_suffix
}
